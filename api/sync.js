import * as api from '@actual-app/api';
import { mkdirSync } from 'fs';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function upstashSet(key, value) {
  const res = await fetch(`${UPSTASH_URL}/set/${key}/${encodeURIComponent(JSON.stringify(value))}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  return res.json();
}

export async function GET(request) {
  // Protect this endpoint with a secret so randos can't trigger it
  const { searchParams } = new URL(request.url);
  if (searchParams.get('secret') !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    mkdirSync('/tmp/actual-cache', { recursive: true });
    
    await api.init({
      dataDir: '/tmp/actual-cache',
      serverURL: process.env.ACTUAL_SERVER_URL,
      password: process.env.ACTUAL_PASSWORD,
    });

    await api.downloadBudget(process.env.ACTUAL_SYNC_ID, {
      password: process.env.ACTUAL_ENCRYPTION_PASSWORD,
    });

    // Get current month in YYYY-MM format
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const budgetMonth = await api.getBudgetMonth(month);

    // Find your target category across all groups
    const targetCategoryName = process.env.BUDGET_CATEGORY_NAME; // e.g. "Groceries"
    let budgetedAmount = null;
    let categoryFound = false;

    for (const group of budgetMonth.categoryGroups) {
      for (const category of group.categories) {
        if (category.name === targetCategoryName) {
          budgetedAmount = category.balance / 100;
          categoryFound = true;
          break;
        }
      }
      if (categoryFound) break;
    }

    await api.shutdown();

    if (!categoryFound) {
      return Response.json({ error: `Category "${targetCategoryName}" not found` }, { status: 404 });
    }

    const payload = {
      category: targetCategoryName,
      budgeted: budgetedAmount,
      month,
      updatedAt: new Date().toISOString(),
    };

    // Store in Upstash
    await upstashSet('budget:amount', payload);

    return Response.json({ ok: true, ...payload });
  } catch (err) {
    console.error(err);
    // Make sure we always shut down the api even on error
    try { await api.shutdown(); } catch {}
    return Response.json({ error: err.message }, { status: 500 });
  }
}

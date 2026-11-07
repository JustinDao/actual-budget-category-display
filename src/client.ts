interface BudgetTransaction {
  date: string;
  amount: number;
  payee: string | null;
  notes: string | null;
}

interface BudgetAssignment {
  month: string;
  amount: number;
}

interface BudgetResponse {
  category: string;
  balance?: number;
  budgeted?: number;
  month?: string;
  updatedAt?: string;
  transactions?: BudgetTransaction[];
  assignments?: BudgetAssignment[];
  error?: string;
}

interface TransactionRow {
  kind: 'txn' | 'assign';
  date: string;
  amount: number;
  payee?: string | null;
  notes?: string | null;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing page element: ${id}`);
  return element as T;
}

const categoryLabel = requiredElement<HTMLParagraphElement>('cat-label');
const amountLabel = requiredElement<HTMLSpanElement>('amount');
const monthLabel = requiredElement<HTMLParagraphElement>('month-label');
const updatedLabel = requiredElement<HTMLParagraphElement>('updated-label');
const transactionScroll = requiredElement<HTMLDivElement>('txns-scroll');
const transactionList = requiredElement<HTMLUListElement>('txns');

function formatMoney(value: number): string {
  return Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function load(): Promise<void> {
  try {
    const response = await fetch('/api/budget');
    const data = (await response.json()) as BudgetResponse;
    if (data.error) throw new Error(data.error);

    categoryLabel.textContent = data.category;

    const amount = Math.abs(data.balance ?? data.budgeted ?? 0);
    amountLabel.textContent = formatMoney(amount);

    if (data.month) {
      const [year, month] = data.month.split('-').map(Number);
      const monthName = new Date(year, month - 1).toLocaleString('en-US', {
        month: 'long',
        year: 'numeric',
      });
      monthLabel.textContent = monthName;
    }

    if (data.updatedAt) {
      const updated = new Date(data.updatedAt);
      updatedLabel.textContent =
        'Updated ' +
        updated.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
    }

    renderTransactions(data);
  } catch (error) {
    categoryLabel.textContent = 'Error';
    amountLabel.textContent = '—';
    monthLabel.classList.add('error');
    monthLabel.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderTransactions(data: BudgetResponse): void {
  const rows: TransactionRow[] = [
    ...(data.transactions ?? []).map((transaction) => ({
      kind: 'txn' as const,
      ...transaction,
    })),
    ...(data.assignments ?? []).map((assignment) => ({
      kind: 'assign' as const,
      date: `${assignment.month}-01`,
      amount: assignment.amount,
    })),
  ].sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? 1 : -1;
    if (left.kind === right.kind) return 0;
    return left.kind === 'assign' ? 1 : -1;
  });

  if (rows.length === 0) {
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'empty';
    emptyMessage.textContent = 'No transactions yet';
    transactionScroll.replaceWith(emptyMessage);
    return;
  }

  for (const row of rows) {
    const [year, month, day] = row.date.split('-').map(Number);
    const dateText = new Date(year, month - 1, day).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    const isAssignment = row.kind === 'assign';

    const item = document.createElement('li');
    item.className = 'txn' + (isAssignment ? ' assign' : '');

    const main = document.createElement('div');
    main.className = 'txn-main';

    const payee = document.createElement('div');
    payee.className = 'txn-payee';
    payee.textContent = isAssignment
      ? 'Budget assigned'
      : row.payee || row.notes || 'Unknown';

    const date = document.createElement('div');
    date.className = 'txn-date';
    date.textContent = dateText;
    main.append(payee, date);

    const amount = document.createElement('div');
    amount.className =
      'txn-amt' + (!isAssignment && row.amount > 0 ? ' refund' : '');
    const sign = row.amount > 0 ? '+' : row.amount < 0 ? '-' : '';
    amount.textContent = sign + '$' + formatMoney(row.amount);

    item.append(main, amount);
    transactionList.append(item);
  }
}

void load();

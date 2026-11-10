import { sha256Hex } from './sha256.js';

declare const __APP_PASSWORD_HASH__: string;

const AUTH_STORAGE_KEY = 'ab_auth_hash_v1';
const APP_PASSWORD_HASH =
  typeof __APP_PASSWORD_HASH__ === 'string' ? __APP_PASSWORD_HASH__ : '';

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

const authGate = requiredElement<HTMLDivElement>('auth-gate');
const authForm = requiredElement<HTMLFormElement>('auth-form');
const authInput = requiredElement<HTMLInputElement>('auth-input');
const authError = requiredElement<HTMLDivElement>('auth-error');
const appContent = requiredElement<HTMLDivElement>('app-content');
const lockButton = requiredElement<HTMLButtonElement>('lock-btn');

const categoryLabel = requiredElement<HTMLParagraphElement>('cat-label');
const amountLabel = requiredElement<HTMLSpanElement>('amount');
const monthLabel = requiredElement<HTMLParagraphElement>('month-label');
const updatedLabel = requiredElement<HTMLParagraphElement>('updated-label');
const transactionScroll = requiredElement<HTMLDivElement>('txns-scroll');
const transactionList = requiredElement<HTMLUListElement>('txns');

let isPasswordRequired = Boolean(APP_PASSWORD_HASH);
let hasLoadedBudget = false;

function formatMoney(value: number): string {
  return Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function getSavedAuthHash(): string {
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveAuthHash(hash: string): void {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, hash);
  } catch {
    // Ignore storage errors
  }
}

function clearAuthHash(): void {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

function checkInitialAuth(): boolean {
  if (!APP_PASSWORD_HASH) {
    return true;
  }
  return getSavedAuthHash() === APP_PASSWORD_HASH;
}

function setAuthError(message: string): void {
  authError.textContent = message;
  authError.hidden = !message;
}

function showAuthGate(errorText = ''): void {
  appContent.hidden = true;
  authGate.hidden = false;
  setAuthError(errorText);
  authInput.focus();
}

function showApp(): void {
  authGate.hidden = true;
  appContent.hidden = false;
  lockButton.hidden = !isPasswordRequired;
  if (!hasLoadedBudget) {
    void load();
  }
}

function unlockApp(event: SubmitEvent): void {
  event.preventDefault();
  const trimmed = authInput.value.trim();
  if (!trimmed) {
    setAuthError('Please enter the password.');
    return;
  }

  const inputHash = sha256Hex(trimmed);
  if (APP_PASSWORD_HASH && inputHash !== APP_PASSWORD_HASH) {
    setAuthError('Incorrect password.');
    return;
  }

  saveAuthHash(inputHash);
  authInput.value = '';
  setAuthError('');
  showApp();
}

function lockApp(): void {
  clearAuthHash();
  authInput.value = '';
  showAuthGate('');
}

async function load(): Promise<void> {
  try {
    const savedHash = getSavedAuthHash();
    const response = await fetch('/api/budget', {
      headers: savedHash ? { 'x-app-auth': savedHash } : {},
    });

    if (response.status === 401) {
      isPasswordRequired = true;
      hasLoadedBudget = false;
      clearAuthHash();
      showAuthGate(savedHash ? 'Incorrect password.' : '');
      return;
    }

    const data = (await response.json()) as BudgetResponse;
    if (data.error) throw new Error(data.error);

    hasLoadedBudget = true;
    lockButton.hidden = !isPasswordRequired;
    monthLabel.classList.remove('error');

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
  transactionList.replaceChildren();

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

authForm.addEventListener('submit', unlockApp);
lockButton.addEventListener('click', lockApp);

if (checkInitialAuth()) {
  showApp();
} else {
  showAuthGate();
}

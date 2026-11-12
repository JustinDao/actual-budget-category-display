import { sha256Hex } from './sha256.js';

declare const __AUTH_REQUIRED__: boolean;

const AUTH_SESSION_STORAGE_KEY = 'ab_auth_session_v2';
const LEGACY_AUTH_HASH_KEY = 'ab_auth_hash_v1';

interface AuthApiResponse {
  ok?: boolean;
  authenticated?: boolean;
  authRequired?: boolean;
  sessionToken?: string;
  error?: string;
}

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
  authRequired?: boolean;
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
const authSubmit = requiredElement<HTMLButtonElement>('auth-submit');
const appContent = requiredElement<HTMLDivElement>('app-content');
const lockButton = requiredElement<HTMLButtonElement>('lock-btn');

const categoryLabel = requiredElement<HTMLParagraphElement>('cat-label');
const amountLabel = requiredElement<HTMLSpanElement>('amount');
const monthLabel = requiredElement<HTMLParagraphElement>('month-label');
const updatedLabel = requiredElement<HTMLParagraphElement>('updated-label');
const transactionScroll = requiredElement<HTMLDivElement>('txns-scroll');
const transactionList = requiredElement<HTMLUListElement>('txns');

let isPasswordRequired =
  typeof __AUTH_REQUIRED__ !== 'undefined' && Boolean(__AUTH_REQUIRED__);
let isUnlocking = false;
let hasLoadedBudget = false;

function formatMoney(value: number): string {
  return Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function isTokenFormatUnexpired(token: string): boolean {
  const parts = token.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !/^[a-f0-9]{64}$/i.test(parts[1])) {
    return false;
  }
  try {
    const base64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const decoded = JSON.parse(atob(padded)) as { exp?: number };
    return typeof decoded?.exp === 'number' && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

function getSavedSessionToken(): string {
  try {
    localStorage.removeItem(LEGACY_AUTH_HASH_KEY);
    const savedToken = localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
    if (savedToken && isTokenFormatUnexpired(savedToken)) {
      return savedToken;
    }
    localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
    return '';
  } catch {
    return '';
  }
}

function saveSessionToken(token: string): void {
  try {
    localStorage.removeItem(LEGACY_AUTH_HASH_KEY);
    if (token) {
      localStorage.setItem(AUTH_SESSION_STORAGE_KEY, token);
    }
  } catch {
    // Ignore storage errors
  }
}

function clearSessionToken(): void {
  try {
    localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
    localStorage.removeItem(LEGACY_AUTH_HASH_KEY);
  } catch {
    // Ignore storage errors
  }
}

function checkInitialAuth(): boolean {
  if (!isPasswordRequired) {
    return true;
  }
  return Boolean(getSavedSessionToken());
}

function setAuthError(message: string): void {
  authError.textContent = message;
  authError.hidden = !message;
}

function clearDisplayedData(): void {
  hasLoadedBudget = false;
  categoryLabel.textContent = 'Loading';
  amountLabel.textContent = '—';
  monthLabel.classList.remove('error');
  monthLabel.textContent = '';
  updatedLabel.textContent = '';
  transactionList.replaceChildren();
}

function showAuthGate(errorText = ''): void {
  appContent.hidden = true;
  lockButton.hidden = true;
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

async function unlockApp(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (isUnlocking) {
    return;
  }

  const trimmed = authInput.value.trim();
  if (!trimmed) {
    setAuthError('Please enter the password.');
    return;
  }

  // Pre-hash on the client so the plaintext password never leaves the browser.
  const clientHash = sha256Hex(trimmed);
  isUnlocking = true;
  authSubmit.disabled = true;
  authSubmit.textContent = 'Verifying...';
  setAuthError('');

  try {
    const response = await fetch('/api/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ clientHash }),
    });

    const data = (await response.json().catch(() => ({}))) as AuthApiResponse;
    if (response.ok && data.ok && data.authenticated) {
      saveSessionToken(data.sessionToken || '');
      if (data.authRequired !== undefined) {
        isPasswordRequired = Boolean(data.authRequired);
      }
      authInput.value = '';
      setAuthError('');
      showApp();
    } else {
      setAuthError(data.error || 'Incorrect password.');
    }
  } catch {
    setAuthError(
      'Unable to reach authentication server. Make sure the API server is running.',
    );
  } finally {
    isUnlocking = false;
    authSubmit.disabled = false;
    authSubmit.textContent = 'Unlock';
  }
}

function lockApp(reason = ''): void {
  clearSessionToken();
  clearDisplayedData();
  authInput.value = '';
  showAuthGate(reason);
}

async function load(): Promise<void> {
  try {
    const savedToken = getSavedSessionToken();
    const response = await fetch('/api/budget', {
      headers: savedToken ? { 'x-app-auth': savedToken } : {},
    });

    if (response.status === 401 || response.status === 403) {
      isPasswordRequired = true;
      lockApp(savedToken ? 'Session expired. Please sign in again.' : '');
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
    monthLabel.textContent =
      error instanceof Error ? error.message : String(error);
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
    const dateText = new Date(year, month - 1, day).toLocaleDateString(
      'en-US',
      {
        month: 'short',
        day: 'numeric',
      },
    );
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

authForm.addEventListener('submit', (event) => {
  void unlockApp(event);
});
lockButton.addEventListener('click', () => {
  lockApp();
});

if (checkInitialAuth()) {
  showApp();
} else {
  showAuthGate();
}

interface PlaidLinkExitError {
  error_message?: string;
  error_code?: string;
}

interface PlaidLinkHandler {
  open(): void;
}

interface PlaidLinkOptions {
  token: string;
  onSuccess(publicToken: string): Promise<void>;
  onExit(error?: PlaidLinkExitError | null): void;
}

declare global {
  interface Window {
    Plaid?: {
      create(options: PlaidLinkOptions): PlaidLinkHandler;
    };
  }
}

const message = document.getElementById('msg');
const linkToken = document.body.dataset.linkToken;

if (!(message instanceof HTMLElement) || !linkToken || !window.Plaid) {
  throw new Error('Plaid Link could not be initialized');
}

const handler = window.Plaid.create({
  token: linkToken,
  onSuccess: async (publicToken) => {
    const response = await fetch('/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ public_token: publicToken }),
    });
    message.textContent = response.ok
      ? 'Connected. Check your terminal for the access token.'
      : 'Exchange failed. Check your terminal.';
  },
  onExit: (error) => {
    message.textContent = error
      ? 'Link exited: ' + (error.error_message || error.error_code)
      : 'Closed.';
  },
});

handler.open();

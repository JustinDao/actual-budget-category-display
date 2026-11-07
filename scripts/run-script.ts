const scriptName = process.argv[2];

switch (scriptName) {
  case 'plaid-debug':
    await import('./plaid-debug.js');
    break;
  case 'plaid-link':
    await import('./build.js');
    await import('./plaid-link.js');
    break;
  case 'run-local':
    await import('./run-local.js');
    break;
  default:
    throw new Error(
      'Choose a script: plaid-debug, plaid-link, or run-local',
    );
}

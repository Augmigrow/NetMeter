// Pinning must be confirmed by Windows, not inferred from creating a .lnk.
export function createPinToStartAction({ installShortcut, requestPin, revealShortcut, showDialog, getStrings }) {
  let pending = null;
  async function run() {
    const text = getStrings();
    const installed = await Promise.resolve().then(installShortcut).catch(() => false);
    if (!installed) {
      await showDialog({ type: 'error', title: text.pinTitle, message: text.pinInstallFailed,
        detail: text.pinInstallFailedDetail, buttons: [text.ok], noLink: true });
      return { state: 'failed' };
    }
    const result = await Promise.resolve().then(requestPin).catch(() => ({ state: 'manual-required' }));
    if (result?.state === 'pinned' || result?.state === 'already-pinned') {
      await showDialog({ type: 'info', title: text.pinTitle,
        message: result.state === 'pinned' ? text.pinSuccess : text.pinAlready,
        buttons: [text.ok], noLink: true });
      return { state: result.state };
    }
    const answer = await showDialog({ type: 'info', title: text.pinTitle, message: text.pinManual,
      detail: text.pinManualDetail, buttons: [text.pinOpenShortcut, text.cancel],
      defaultId: 0, cancelId: 1, noLink: true });
    if (answer.response === 0) {
      await revealShortcut();
      return { state: 'manual-required', revealed: true };
    }
    return { state: 'manual-required', revealed: false };
  }
  return function pinToStart() {
    if (pending) return pending;
    pending = run().finally(() => { pending = null; });
    return pending;
  };
}

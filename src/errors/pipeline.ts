export class PipelineStructureChangedError extends Error {
  readonly storedFingerprint: string;
  readonly currentFingerprint: string;
  readonly sessionId: string;

  constructor(
    sessionId: string,
    storedFingerprint: string,
    currentFingerprint: string,
    message?: string,
  ) {
    super(
      message ??
        `Cannot resume session "${sessionId}": pipeline structure has changed. ` +
          `Stored fingerprint: ${storedFingerprint}, current: ${currentFingerprint}. ` +
          `Manual intervention required.`,
    );
    this.name = 'PipelineStructureChangedError';
    this.sessionId = sessionId;
    this.storedFingerprint = storedFingerprint;
    this.currentFingerprint = currentFingerprint;
  }
}

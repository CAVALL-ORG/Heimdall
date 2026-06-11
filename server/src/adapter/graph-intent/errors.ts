export type BuildFromGraphErrorCode =
  | 'schema_invalid'
  | 'count_mismatch'
  | 'translator_failed'
  | 'stereo_transfer_failed'
  | 'stereo_cip_unreachable'
  | 'under_valent_atom';

export class BuildFromGraphError extends Error {
  readonly code: BuildFromGraphErrorCode;
  readonly details: unknown;

  constructor(code: BuildFromGraphErrorCode, details: unknown, messageSuffix?: string) {
    super(`build_from_graph ${code}${messageSuffix ? ` ${messageSuffix}` : ''}`);
    this.name = 'BuildFromGraphError';
    this.code = code;
    this.details = details;
  }
}

export type DenseExportAuthorizationErrorCode = 'dense_export_blocked';

// Retained narrowly for the runtime SMILES-error → molfile/KET fail-closed
// invariant (HISTORY-locked May-2026 fix; see runtime.ts narrowed redaction).
// All other dense state-machine usages were deleted in Phase 2c.
export class DenseExportAuthorizationError extends Error {
  readonly code: DenseExportAuthorizationErrorCode;
  readonly details: unknown;

  constructor(details: unknown) {
    super('dense export blocked');
    this.name = 'DenseExportAuthorizationError';
    this.code = 'dense_export_blocked';
    this.details = details;
  }
}

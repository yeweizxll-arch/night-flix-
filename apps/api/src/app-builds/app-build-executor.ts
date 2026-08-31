import type { AppBuildTarget } from './app-build.types';

export const APP_BUILD_EXECUTOR = Symbol('APP_BUILD_EXECUTOR');

export type AppBuildFailureCode =
  | 'artifact_upload_failed'
  | 'asset_unavailable'
  | 'builder_unavailable'
  | 'build_failed'
  | 'job_timed_out';

export interface AppBuildExecutionInput {
  jobId: string;
  snapshot: Record<string, unknown>;
  target: AppBuildTarget;
  tenantId: string;
}

export interface AppBuildExecutionArtifact {
  checksum: `sha256:${string}`;
  contentType: 'application/vnd.android.package-archive' | 'application/zip';
  filename: string;
  objectKey: string;
  sizeBytes: bigint;
  storageProviderId: string;
}

export interface AppBuildExecutor {
  execute(input: AppBuildExecutionInput): Promise<AppBuildExecutionArtifact>;
}

export class AppBuildExecutionError extends Error {
  constructor(readonly code: AppBuildFailureCode) {
    super(code);
    this.name = 'AppBuildExecutionError';
  }
}

export class DisabledAppBuildExecutor implements AppBuildExecutor {
  async execute(): Promise<never> {
    throw new AppBuildExecutionError('builder_unavailable');
  }
}

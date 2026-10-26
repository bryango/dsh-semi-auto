/// <reference types="node" />

export interface UpstreamMetadata {
  repository: string
  version: string
  commit: string
  files: {
    autoReview: { path: string; sha256: string }
    license: { path: string; sha256: string }
  }
}

export function sha256(bytes: Buffer): string
export function generateReviewer(sourceBytes: Buffer, metadata: UpstreamMetadata): string
export function expectedReviewer(): Promise<string>

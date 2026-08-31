export interface TlsAdvanceCandidate {
  enabled: boolean;
  tlsStatus: string;
  verification: { status: string };
}

export function canAdvanceTlsStatus(
  domain: TlsAdvanceCandidate,
  endpointConfigured: boolean,
): boolean {
  return endpointConfigured
    && domain.enabled
    && domain.verification.status === 'verified'
    && domain.tlsStatus !== 'active';
}

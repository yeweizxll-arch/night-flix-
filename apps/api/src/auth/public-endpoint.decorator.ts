import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ENDPOINT_METADATA = Symbol('drama.auth.public-endpoint');

/** Explicitly opts an endpoint out of authentication and RBAC. */
export const PublicEndpoint = () => SetMetadata(PUBLIC_ENDPOINT_METADATA, true);


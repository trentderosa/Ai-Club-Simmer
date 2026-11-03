export interface AuthenticatedUser {
  id: string;
  email?: string;
}

export interface JWTPayload {
  sub: string;
  email?: string;
  aud: string;
  role: string;
  iat: number;
  exp: number;
}

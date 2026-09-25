import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Lindungi seluruh halaman aplikasi: tanpa cookie sesi -> ke /login.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has('qgis_token') || req.cookies.has('qgis_session');
  if (pathname === '/login') {
    if (hasSession) return NextResponse.redirect(new URL('/map', req.url));
    return NextResponse.next();
  }
  if (!hasSession) {
    const url = new URL('/login', req.url);
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|icons).*)'],
};

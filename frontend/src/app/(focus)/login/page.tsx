import { Suspense } from "react";
import type { Metadata } from "next";
import LoginClient from "./LoginClient";

export const metadata: Metadata = {
  title: "Sign in · Markdrop",
  robots: { index: false, follow: true },
};

/** /login: the shared SignInForm, with the product vignette beside it on wide screens (REVAMP_PLAN 7.14). */
export default function LoginPage() {
  // LoginClient reads `next` and `error` with useSearchParams, so it sits in Suspense: the route
  // still prerenders (the fallback is the empty frame; the form appears on hydration).
  return (
    <Suspense fallback={null}>
      <LoginClient />
    </Suspense>
  );
}

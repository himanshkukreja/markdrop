"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";

export default function AuthCallback() {
  const router = useRouter();
  const { login } = useAuth();
  const [error, setError] = useState(false);

  useEffect(() => {
    // Token arrives in the URL fragment (never sent to the server).
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const params = new URLSearchParams(hash);
    const token = params.get("token");
    const next = params.get("next");

    if (!token) {
      setError(true);
      return;
    }

    (async () => {
      await login(token);
      // Strip the token from the URL history entry.
      const dest = next && next.startsWith("/") ? next : "/dashboard";
      router.replace(dest);
    })();
  }, [login, router]);

  return (
    <div className="flex-1 flex items-center justify-center">
      {error ? (
        <div className="text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">Sign-in link was invalid.</p>
          <a href="/login" className="text-sm text-blue-500 hover:underline">Back to login</a>
        </div>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">Signing you in…</p>
      )}
    </div>
  );
}

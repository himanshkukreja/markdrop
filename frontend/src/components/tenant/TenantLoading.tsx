"use client";

import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui";

/**
 * The loading state on a workspace's own domain. Deliberately not `MarkdropLoader`: the brand
 * loader would put Markdrop's mark on the customer's site. Shows after 300ms like the brand
 * loader, so fast loads never flash; the space is reserved meanwhile.
 */
export function TenantLoading({ label = "Opening document" }: { label?: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center">
      {shown && (
        <div role="status" className="flex items-center gap-3 text-body text-text-secondary">
          <Spinner size={20} />
          <span>{label}</span>
        </div>
      )}
    </div>
  );
}

export default TenantLoading;

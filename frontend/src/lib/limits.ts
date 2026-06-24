const configuredMaxChars = Number(process.env.NEXT_PUBLIC_MAX_CONTENT_CHARS);

export const MAX_CHARS =
  Number.isFinite(configuredMaxChars) && configuredMaxChars > 0
    ? configuredMaxChars
    : 500_000;

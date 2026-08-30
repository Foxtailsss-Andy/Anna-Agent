declare const __ANNA_PI_KERNEL_SOURCE_SHA256__: string;

export const expectedPiKernelSourceSha256: string | undefined =
  typeof __ANNA_PI_KERNEL_SOURCE_SHA256__ === "undefined"
    ? undefined
    : __ANNA_PI_KERNEL_SOURCE_SHA256__;

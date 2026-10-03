const seconds = Number(process.env.SOAK_SECONDS);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
  throw new Error("SOAK_SECONDS must be between 5 and 3600");
}

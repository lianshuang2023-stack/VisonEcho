const overviewHashes = new Set(['', '#', '#about', '#features', '#timing', '#impact', '#how-it-works', '#questions', '#introduction', '#sample']);

export function isOverviewHash(hash: string): boolean {
  return overviewHashes.has(hash);
}

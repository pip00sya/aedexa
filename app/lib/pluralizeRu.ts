export function pluralizeRu(value: number, one: string, few: string, many: string) {
  const mod100 = Math.abs(value) % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = mod100 % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

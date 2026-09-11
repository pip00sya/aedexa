export function hex(color: number) {
  return `#${Math.max(0, Math.min(0xffffff, Math.round(color)))
    .toString(16)
    .padStart(6, "0")}`;
}
export function shade(color: number, factor: number) {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value * factor)));
  return (
    (channel((color >> 16) & 255) << 16) | (channel((color >> 8) & 255) << 8) | channel(color & 255)
  );
}

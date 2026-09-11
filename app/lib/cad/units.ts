export function cadUnitsToMeters(unitLabel: string) {
  const label = unitLabel.toLowerCase();
  if (label.includes("мм") || label.includes("millimeter")) return 0.001;
  if (label.includes("см") || label.includes("centimeter")) return 0.01;
  return 1;
}

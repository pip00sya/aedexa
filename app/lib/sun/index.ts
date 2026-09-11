import { convexHull, type XY, type XYBounds } from "../geometry";

export type SunPosition = {
  altitudeDeg: number;
  /** Азимут солнца в градусах по часовой стрелке от севера */
  azimuthDeg: number;
};

/** День года весеннего равноденствия - по нему считают тени по умолчанию */
export const EQUINOX_DAY = 80;
/** Алматы - показательный нормативный профиль программы */
export const ALMATY_LATITUDE = 43.25;

const RAD = Math.PI / 180;

/** Ряд Спенсера (1971) для склонения солнца, точность около 0,3° */
function solarDeclinationRad(dayOfYear: number) {
  const gamma = (2 * Math.PI * (dayOfYear - 1)) / 365;
  return (
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma)
  );
}

export function solarPosition(
  latitudeDeg: number,
  dayOfYear: number,
  solarHour: number,
): SunPosition {
  const latitude = latitudeDeg * RAD;
  const declination = solarDeclinationRad(dayOfYear);
  const hourAngle = (solarHour - 12) * 15 * RAD;
  const sinAltitude =
    Math.sin(latitude) * Math.sin(declination) +
    Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAltitude)));
  const cosAzimuth =
    (Math.sin(declination) - Math.sin(altitude) * Math.sin(latitude)) /
    Math.max(1e-12, Math.cos(altitude) * Math.cos(latitude));
  let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAzimuth))) / RAD;
  if (hourAngle > 0) azimuth = 360 - azimuth;
  return { altitudeDeg: altitude / RAD, azimuthDeg: azimuth };
}

export function shadowVector(
  position: SunPosition,
  height: number,
  yNorthSign: 1 | -1 = 1,
): XY | null {
  if (position.altitudeDeg <= 0.5 || height <= 0) return null;
  const length = height / Math.tan(position.altitudeDeg * RAD);
  const azimuth = position.azimuthDeg * RAD;
  // Тень смотрит от солнца - в сторону, обратную его азимуту
  return { x: -Math.sin(azimuth) * length, y: -Math.cos(azimuth) * length * yNorthSign };
}

/** Тень прямоугольного объема: оболочка основания и его сдвинутой копии */
export function rectShadowPolygon(
  rect: XYBounds,
  height: number,
  position: SunPosition,
  yNorthSign: 1 | -1 = 1,
): XY[] | null {
  const offset = shadowVector(position, height, yNorthSign);
  if (!offset) return null;
  const corners: XY[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  const displaced = corners.map((corner) => ({ x: corner.x + offset.x, y: corner.y + offset.y }));
  return convexHull([...corners, ...displaced]);
}

/** Тень любой призмы: оболочка контура основания и его сдвинутой копии */
export function ringShadowPolygon(
  ring: readonly XY[],
  height: number,
  position: SunPosition,
  yNorthSign: 1 | -1 = 1,
): XY[] | null {
  const offset = shadowVector(position, height, yNorthSign);
  if (!offset || ring.length < 3) return null;
  const displaced = ring.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));
  return convexHull([...ring, ...displaced]);
}

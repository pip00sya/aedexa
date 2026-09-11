/** Знак AEDEXA */

type MarkProps = {
  /** Сторона знака в пикселях */
  size?: number;
  /** Дополнительный класс для позиционирования */
  className?: string;
};

export default function Mark({ size = 34, className }: MarkProps) {
  return (
    <svg
      className={className ? `aedexa-glyph ${className}` : "aedexa-glyph"}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="currentColor"
      role="img"
      aria-label="AEDEXA"
    >
      {/* Левая грань смотрит на свет */}
      <path d="M16 3 3 27l13-8z" />
      {/* Правая отвернулась */}
      <path d="M16 3 29 27l-13-8z" opacity="0.8" />
      {/* Нижняя лежит в тени */}
      <path d="M3 27h26l-13-8z" opacity="0.58" />
    </svg>
  );
}

/**
 * IrisPetal · 鸢尾瓣点缀(《设计说明 · Iris》§5)
 *
 * 三色固定 lavender/iris/gold,禁改色;永不动画。
 * 白名单:① 侧栏品牌行 13px ② 空态插图位 26px ③ 问候页标题旁 16px
 * 禁区:运行时间线、数据行、按钮、表格。硬上限:每屏 2 处。
 */

interface IrisPetalProps {
  /** 13 | 16 | 26(白名单尺寸);默认 13 */
  size?: number;
  className?: string;
}

export function IrisPetal({ size = 13, className }: IrisPetalProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2.8c2.3 2.6 2.3 6 0 8.6-2.3-2.6-2.3-6 0-8.6Z" fill="#8B8ED9" />
      <path d="M4.6 9.6c3.4-.4 6 1.2 7.1 4.5-3.4.4-6-1.2-7.1-4.5Z" fill="#B7B9E8" />
      <path d="M19.4 9.6c-1.1 3.3-3.7 4.9-7.1 4.5 1.1-3.3 3.7-4.9 7.1-4.5Z" fill="#CBBB8E" />
      <circle cx="12" cy="12.6" r="1.2" fill="#575BC4" />
    </svg>
  );
}

/** 「安」印(§5):只落在「礼成」条上;微倾 -4°,如亲手钤印 */
export function AnSeal({ size = 18 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        border: '1px solid #C99B95',
        borderRadius: 4,
        color: 'var(--danger)',
        fontFamily: 'var(--font-serif)',
        fontSize: Math.round(size * 0.56),
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: 'rotate(-4deg)',
        flex: 'none',
      }}
    >
      安
    </span>
  );
}

/**
 * BloomIris · 绽放鸢尾(5a 装饰套件 v2)
 * 六瓣花体:三立瓣(lavender→iris 透明渐变)+ 三垂瓣(iris→透明)+ 金蕊。
 * 白名单尺寸:96 问候页/关于 · 52 空态 · 26 品牌行。永不动画,渐变必须收于透明。
 */
export function BloomIris({ size = 52 }: { size?: number }) {
  const id = Math.random().toString(36).slice(2, 8);
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`bs${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#C7C9EF" /><stop offset="1" stopColor="#575BC4" stopOpacity="0.45" />
        </linearGradient>
        <linearGradient id={`bf${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#575BC4" stopOpacity="0.6" /><stop offset="1" stopColor="#8B8ED9" stopOpacity="0.14" />
        </linearGradient>
        <linearGradient id={`bg${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#D9CBA3" /><stop offset="1" stopColor="#CBBB8E" stopOpacity="0.3" />
        </linearGradient>
      </defs>
      <path d="M50 6 C62 21 62 42 50 56 C38 42 38 21 50 6 Z" fill={`url(#bs${id})`} opacity="0.9" />
      <path d="M50 56 C36 47 27 32 29 15 C44 21 51 37 50 56 Z" fill={`url(#bs${id})`} opacity="0.62" />
      <path d="M50 56 C64 47 73 32 71 15 C56 21 49 37 50 56 Z" fill={`url(#bs${id})`} opacity="0.62" />
      <path d="M50 56 C33 53 19 61 13 78 C31 84 47 75 50 56 Z" fill={`url(#bf${id})`} />
      <path d="M50 56 C67 53 81 61 87 78 C69 84 53 75 50 56 Z" fill={`url(#bf${id})`} />
      <path d="M50 56 C45 70 45 84 50 95 C55 84 55 70 50 56 Z" fill={`url(#bf${id})`} opacity="0.8" />
      <path d="M50 47 C52.5 52 52.5 58 50 63 C47.5 58 47.5 52 50 47 Z" fill={`url(#bg${id})`} />
    </svg>
  );
}

/** 瓣饰分隔线(§5 ④):长文档/设置页章节分隔;占点缀名额 */
export function PetalDivider() {
  return (
    <div aria-hidden="true" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
      <IrisPetal size={12} />
      <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
    </div>
  );
}

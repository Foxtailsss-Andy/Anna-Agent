/**
 * ArtifactCard · 行内产物卡(《设计说明 · Iris》§6.5)
 * 数据源:run.artifacts(产物是一等公民);点击 → 沙箱画布自动展开并定位。
 */

import './ArtifactCard.css';

export interface ArtifactCardProps {
  name: string;
  /** 如「网页产物 · 刚刚生成 · run 9F3KE2」 */
  metaText: string;
  onOpen: () => void;
}

export function ArtifactCard({ name, metaText, onOpen }: ArtifactCardProps) {
  return (
    <button type="button" className="afc" onClick={onOpen}>
      <span className="afc__tile" aria-hidden="true">◇</span>
      <span className="afc__body">
        <span className="afc__name">{name}</span>
        <span className="afc__meta">{metaText}</span>
      </span>
      <span className="afc__open">在画布打开 ↗</span>
    </button>
  );
}

export default ArtifactCard;

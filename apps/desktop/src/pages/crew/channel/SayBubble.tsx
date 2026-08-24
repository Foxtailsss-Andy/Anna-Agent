/**
 * SayBubble · 人话纸面气泡(1d ④ + R1 链接卡):结=人圆 · 纸面 #F2F1EC r12
 *   文 12.3/1.7 墨字;正文 @提及 高亮(iris/delegate);正文含外链(http/https)→ 气泡下
 *   附链接卡(中性地球 + 单「外链」动作,浏览器打开)。零捏造:链接来自真发言正文。
 *   站内产物内联引用 chip:当前数据模型无 say-产物引用字段 → 略去(登记偏差,不造数据)。
 */

import { LinkCard } from "./AttachmentChip";
import { MentionBody, MessageRow, type RowAuthor } from "./ChronicleLine";
import { extractUrls } from "./artifactChip";
import type { MentionMeta } from "./channelModel";

export interface SayBubbleProps {
  author: RowAuthor;
  time: string;
  body: string;
  mentions: MentionMeta[];
}

export function SayBubble({ author, time, body, mentions }: SayBubbleProps) {
  const urls = extractUrls(body);
  return (
    <MessageRow author={author} time={time} audit="">
      <div className="ir-chan-say">
        <MentionBody body={body} mentions={mentions} className="ir-chan-say__body" />
      </div>
      {urls.length > 0 && (
        <div className="ir-chan-say__links">
          {urls.map((u) => (
            <LinkCard key={u} url={u} />
          ))}
        </div>
      )}
    </MessageRow>
  );
}

export default SayBubble;

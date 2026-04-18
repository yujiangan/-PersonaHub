import { useState } from 'react';

interface ThinkingCardProps {
  content: string;
}

export default function ThinkingCard({ content }: ThinkingCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // 截取第一行作为摘要
  const firstLine = content.split('\n')[0];
  const isMultiLine = content.includes('\n');

  return (
    <div className="thinking-card">
      <div
        className="card-header thinking-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="card-header-left">
          <span className="thinking-icon">💭</span>
          <span className="card-title">AI 思考</span>
        </div>
        {isMultiLine && (
          <span className="expand-icon">{isExpanded ? '▲ 收起' : '▼ 展开'}</span>
        )}
      </div>
      <div className={`card-body thinking-body ${isExpanded ? 'expanded' : ''}`}>
        <div className="card-body-inner">
          <div>
            {isExpanded ? content : firstLine}
          </div>
        </div>
      </div>
    </div>
  );
}

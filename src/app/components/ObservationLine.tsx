interface ObservationLineProps {
  content: string;
}

export default function ObservationLine({ content }: ObservationLineProps) {
  return (
    <div className="observation-line">
      <span className="observation-arrow">↳</span>
      <span className="observation-content">{content}</span>
    </div>
  );
}

import { useState, useCallback } from "react";

interface SearchBarProps {
  onSearch: (githubId: string) => void;
  isAnalyzing: boolean;
}

export default function SearchBar({ onSearch, isAnalyzing }: SearchBarProps) {
  const [inputValue, setInputValue] = useState("");

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = inputValue.trim();
      if (!trimmed) return;
      if (isAnalyzing) return;
      onSearch(trimmed);
    },
    [inputValue, isAnalyzing, onSearch],
  );

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: "32px" }}>
      <div style={{ display: "flex", gap: "10px", maxWidth: "500px", margin: "0 auto" }}>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="输入 GitHub 用户名，如 yujiangan"
          disabled={isAnalyzing}
          style={{
            flex: 1,
            padding: "12px 16px",
            fontSize: "14px",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "10px",
            outline: "none",
            background: "rgba(255, 255, 255, 0.03)",
            color: "#e2e8f5",
            transition: "border-color 0.2s, box-shadow 0.2s",
          }}
          onFocus={(e) => {
            e.target.style.borderColor = "rgba(59,130,246,0.5)";
            e.target.style.boxShadow = "0 0 0 2px rgba(96, 165, 250, 0.2)";
            e.target.style.color = "#e2e8f5";
          }}
          onBlur={(e) => {
            e.target.style.borderColor = "rgba(255,255,255,0.1)";
            e.target.style.boxShadow = "none";
            e.target.style.color = "#e2e8f5";
          }}
        />
        <button
          type="submit"
          disabled={isAnalyzing || !inputValue.trim()}
          style={{
            padding: "12px 24px",
            fontSize: "14px",
            fontWeight: 500,
            backgroundColor: isAnalyzing ? "#1c2333" : "#1e3b5e",
            color: isAnalyzing ? "#4a5a72" : "#93c5fd",
            border: "1px solid rgba(59,130,246,0.3)",
            borderRadius: "10px",
            cursor: isAnalyzing ? "not-allowed" : "pointer",
            transition: "all 0.15s",
            boxShadow: isAnalyzing ? "none" : "0 2px 8px rgba(59,130,246,0.2)",
          }}
        >
          {isAnalyzing ? "⏳ 分析中..." : "🔍 开始分析"}
        </button>
      </div>
    </form>
  );
}

import { useState } from 'react';
import SearchBar from './components/SearchBar';
import AgentStream from './components/AgentStream';
import { useAnalysis } from './hooks/useAnalysis';

function App() {
  const [githubId, setGithubId] = useState<string | null>(null);
  const {
    finalReport,
    error,
    isDone,
    isGeneratingReport,
    events,
    observationsByTool,
  } = useAnalysis(githubId);

  const handleSearch = (id: string) => setGithubId(id);

  const isAnalyzing = !!githubId && !isDone;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f1117',
      color: '#e2e8f0',
      padding: '40px 20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    }}>
      <div style={{ maxWidth: '760px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '20px', color: '#94a3b8', marginBottom: '32px', letterSpacing: '0.05em', textAlign: 'center' }}>
          ⚡ PersonaHub — GitHub 用户分析
        </h1>
        <SearchBar onSearch={handleSearch} isAnalyzing={isAnalyzing} />
        <AgentStream
          finalReport={finalReport}
          isDone={isDone}
          error={error}
          isGeneratingReport={isGeneratingReport}
          events={events}
          observationsByTool={observationsByTool}
        />
      </div>
    </div>
  );
}

export default App;

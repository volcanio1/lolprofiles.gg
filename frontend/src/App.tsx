import { Route, Routes } from 'react-router-dom';
import { ProfileReportPage } from './pages/ProfileReportPage';
import { SearchPage } from './pages/SearchPage';

/**
 * Top-level route table. The router itself is provided by the caller
 * (`BrowserRouter` in main.tsx, `MemoryRouter` in tests).
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<SearchPage />} />
      <Route path="/profile" element={<ProfileReportPage />} />
    </Routes>
  );
}

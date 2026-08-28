import { Route, Routes } from 'react-router-dom';
import { LiveGamePage } from './pages/LiveGamePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProfileReportPage } from './pages/ProfileReportPage';
import { SearchPage } from './pages/SearchPage';
import { TestIconsPage } from './pages/TestIconsPage';
import { StaticDataContextProvider } from './staticData';

/**
 * Top-level route table. The router itself is provided by the caller
 * (`BrowserRouter` in main.tsx, `MemoryRouter` in tests).
 *
 * `StaticDataContextProvider` wraps every route here rather than just
 * `ProfileReportPage`, so a visitor who lands on `/profile` directly (a shared
 * link, a refresh) still gets the version fetch kicked off from the first
 * render instead of racing it against navigation.
 */
export function App() {
  return (
    <StaticDataContextProvider>
      <Routes>
        <Route path="/" element={<SearchPage />} />
        <Route path="/profile" element={<ProfileReportPage />} />
        <Route path="/live" element={<LiveGamePage />} />
        <Route path="/test" element={<TestIconsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </StaticDataContextProvider>
  );
}

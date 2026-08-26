import { Route, Routes } from 'react-router-dom';
import { ProfileReportPage } from './pages/ProfileReportPage';
import { SearchPage } from './pages/SearchPage';
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
      </Routes>
    </StaticDataContextProvider>
  );
}

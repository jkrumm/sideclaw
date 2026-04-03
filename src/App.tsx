import { BrowserRouter, Route, Routes } from "react-router-dom";
import { RepoList } from "./pages/RepoList";
import { RepoDashboard } from "./pages/RepoDashboard";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RepoList />} />
        <Route path="/:workspace/:repo" element={<RepoDashboard />} />
      </Routes>
    </BrowserRouter>
  );
}

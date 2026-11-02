import { loadTitleFaces } from '../lib/title-fonts'
import { AppProviders } from './providers'

// The page title face loads with the app, before any title draws
// (styles/title-fonts.css).
loadTitleFaces()

export function App() {
  return <AppProviders />
}

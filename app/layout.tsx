import './style.css'
export const metadata = {
  title: 'OpenPassword · Workspace',
  description: 'Manage provider connections and scoped access.',
}
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

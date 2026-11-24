'use client'
import { useEffect, useState } from 'react'
import { SunMoon } from 'lucide-react'
export function Appearance() {
  const [value, set] = useState('system')
  useEffect(() => {
    const sync = () => set(document.documentElement.dataset.appearance || 'system')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-appearance'],
    })
    return () => observer.disconnect()
  }, [])
  return (
    <label className="appearance">
      <SunMoon size={17} />
      <select
        aria-label="Appearance"
        value={value}
        onChange={(e) =>
          window.dispatchEvent(
            new CustomEvent('openpassword-appearance', { detail: e.target.value }),
          )
        }
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  )
}

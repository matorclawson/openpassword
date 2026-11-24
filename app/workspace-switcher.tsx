'use client'
import { useEffect, useRef, useState } from 'react'
import { Building2, Check, ChevronsUpDown, Plus, Search } from 'lucide-react'
export function WorkspaceSwitcher({
  spaces,
  current,
  canCreate,
  change,
  create,
}: {
  spaces: { id: string; label: string }[]
  current: string
  canCreate: boolean
  change: (id: string) => void
  create: () => void
}) {
  const [open, O] = useState(false),
    [query, Q] = useState('')
  const area = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const outside = (e: PointerEvent) => {
      if (!area.current?.contains(e.target as Node)) O(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  function close() {
    O(false)
    trigger.current?.focus()
  }
  const matches = spaces.filter((s) => s.label.toLowerCase().includes(query.toLowerCase()))
  return (
    <div
      ref={area}
      className="spaceSwitcher"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          close()
          return
        }
        if (!open || !['ArrowDown', 'ArrowUp'].includes(e.key)) return
        e.preventDefault()
        const options = Array.from(
          area.current!.querySelectorAll<HTMLButtonElement>('.spaceMenu button'),
        )
        const i = options.indexOf(document.activeElement as HTMLButtonElement)
        options[
          Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
        ]?.focus()
      }}
    >
      <button
        ref={trigger}
        className="spaceTrigger"
        aria-expanded={open}
        aria-label={'Choose workspace, current ' + spaces.find((s) => s.id === current)?.label}
        onClick={() => {
          Q('')
          O(!open)
        }}
      >
        <Building2 size={16} />
        <span>{spaces.find((s) => s.id === current)?.label}</span>
        <ChevronsUpDown size={14} />
      </button>
      {open && (
        <div className="spaceMenu">
          <label>
            <Search size={15} />
            <input
              ref={input}
              aria-label="Find a workspace"
              placeholder="Find a workspace"
              value={query}
              onChange={(e) => Q(e.target.value)}
            />
          </label>
          {matches.map((s) => (
            <button
              key={s.id}
              aria-current={s.id === current ? 'true' : undefined}
              onClick={() => {
                close()
                if (s.id !== current) change(s.id)
              }}
            >
              {s.label}
              {s.id === current && <Check size={15} />}
            </button>
          ))}
          {!matches.length && <p>No matching workspaces.</p>}
          {canCreate && (
            <button
              onClick={() => {
                close()
                create()
              }}
            >
              <Plus size={16} />
              New workspace
            </button>
          )}
        </div>
      )}
    </div>
  )
}

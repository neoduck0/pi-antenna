// /websearch picker, laid out like Pi's built-in /thinking and /model selectors.

import type { Theme } from "@earendil-works/pi-coding-agent"
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent"
import {
  Container,
  fuzzyFilter,
  Input,
  type KeybindingsManager,
  type KeyId,
  matchesKey,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui"

const LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 }
// Reuse the "save as default" key from Pi's /model selector so it follows the user's keybindings.
const SAVE_BINDING = "app.models.save"
const SAVE_FALLBACK = "ctrl+s"

export type SelectorResult = { value: string; persist: boolean } | undefined

const capitalize = (part: string) => part.charAt(0).toUpperCase() + part.slice(1)

export class WebSearchSelector extends Container {
  private searchInput = new Input()
  private selectList: SelectList
  private selectListIndex: number
  private allItems: SelectItem[]
  private _focused = false
  private keybindings: KeybindingsManager
  private done: (result: SelectorResult) => void

  get focused() {
    return this._focused
  }
  set focused(value: boolean) {
    this._focused = value
    this.searchInput.focused = value
  }

  constructor(
    theme: Theme,
    keybindings: KeybindingsManager,
    options: { current: string; saved: string; items: string[] },
    done: (result: SelectorResult) => void,
  ) {
    super()
    this.keybindings = keybindings
    this.done = done
    this.allItems = options.items.map((value) => ({
      value,
      label: `${value === options.current ? "✓ " : "  "}${value}`,
      description: value === options.saved ? "default" : undefined,
    }))

    const border = (s: string) => theme.fg("border", s)
    this.addChild(new DynamicBorder(border))
    this.addChild(new Spacer(1))
    this.addChild(new Text("Web Search Provider", 0, 0))
    this.addChild(new Spacer(1))
    this.searchInput.onSubmit = () => this.selectList.handleInput("\r")
    this.addChild(this.searchInput)
    this.addChild(new Spacer(1))
    this.selectList = this.buildSelectList(this.allItems, options.current)
    this.selectListIndex = this.children.length
    this.addChild(this.selectList)
    this.addChild(new Spacer(1))
    const key = (id: string) => this.keyText(id)
    this.addChild(
      new Text(
        theme.fg(
          "dim",
          `  ${key("tui.select.confirm")} to select · ${key(SAVE_BINDING)} to set as default · ${key("tui.select.cancel")} to cancel`,
        ),
        0,
        0,
      ),
    )
    this.addChild(new DynamicBorder(border))
  }

  /** Keys bound to `id`, falling back to `fallback` if Pi no longer defines that binding. */
  private keysFor(id: string, fallback?: string) {
    const keys = this.keybindings.getKeys(id as never) as string[]
    return keys.length || !fallback ? keys : [fallback]
  }

  private keyText(id: string) {
    return this.keysFor(id, id === SAVE_BINDING ? SAVE_FALLBACK : undefined)
      .map((k) =>
        k
          .split("+")
          .map((part) => capitalize(process.platform === "darwin" && part === "alt" ? "option" : part))
          .join("+"),
      )
      .join("/")
  }

  private buildSelectList(items: SelectItem[], preselect: string | undefined) {
    const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), LAYOUT)
    const index = items.findIndex((item) => item.value === preselect)
    if (index !== -1) list.setSelectedIndex(index)
    list.onSelect = (item) => this.done({ value: item.value, persist: false })
    list.onCancel = () => this.done(undefined)
    return list
  }

  private applyFilter(query: string) {
    const filtered = query ? fuzzyFilter(this.allItems, query, (item) => item.value) : this.allItems
    const next = this.buildSelectList(filtered, this.selectList.getSelectedItem()?.value)
    this.children[this.selectListIndex] = next
    this.selectList = next
  }

  handleInput(data: string) {
    const kb = this.keybindings
    if (this.keysFor(SAVE_BINDING, SAVE_FALLBACK).some((key) => matchesKey(data, key as KeyId))) {
      const item = this.selectList.getSelectedItem()
      if (item) this.done({ value: item.value, persist: true })
      return
    }
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.confirm") ||
      kb.matches(data, "tui.select.cancel")
    ) {
      this.selectList.handleInput(data)
      return
    }
    this.searchInput.handleInput(data)
    this.applyFilter(this.searchInput.getValue())
  }
}

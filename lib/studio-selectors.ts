import type { Frame, Locator, Page } from 'playwright'

/**
 * SINGLE SOURCE OF TRUTH for all Google AI Studio (aistudio.google.com) DOM selectors.
 * Every UI element has an ordered fallback chain (aria-label, role, text, CSS) so that
 * if AI Studio updates its layout, only this file needs to be edited.
 */
export const STUDIO_URLS = {
  base: 'https://aistudio.google.com',
  newChat: 'https://aistudio.google.com/prompts/new_chat',
  appPrompts: 'https://aistudio.google.com/app/prompts/new_chat',
} as const

export const STUDIO_SELECTORS = {
  /** Account / profile indicator when logged in */
  accountIndicators: [
    'a[aria-label*="Google Account" i]',
    'button[aria-label*="Google Account" i]',
    'img[alt*="Account" i]',
    'ms-prompt-Input-wrapper',
    'ms-autosize-textarea',
    'textarea[aria-label*="Type something" i]',
    'textarea[placeholder*="Type something" i]',
  ],

  /** Google sign-in form indicators when logged out */
  loggedOutIndicators: [
    'input[type="email"]',
    'a[href*="accounts.google.com/ServiceLogin"]',
    'button:has-text("Sign in")',
  ],

  /** Terms / onboarding / welcome dialog dismissal buttons (strictly scoped to modal dialogs, never Run Settings panel) */
  dismissDialogs: [
    'mat-dialog-container button:has-text("Accept")',
    'mat-dialog-container button:has-text("I agree")',
    'mat-dialog-container button:has-text("Got it")',
    'mat-dialog-container button:has-text("Continue")',
    '[role="dialog"] button:has-text("Accept")',
    '[role="dialog"] button:has-text("I agree")',
    '[role="dialog"] button:has-text("Got it")',
  ],

  /** New Chat / Create new prompt button */
  newChatButtons: [
    'a[href*="/prompts/new_chat"]',
    'button[aria-label*="New chat" i]',
    'button[aria-label*="Create new" i]',
    'a:has-text("Create new")',
    'button:has-text("Create new")',
    'a:has-text("Chat")',
  ],

  /** Right-side Run Settings panel toggle (if collapsed) */
  runSettingsToggle: [
    'button[aria-label="Toggle run settings panel" i]',
    'button.runsettings-toggle-button',
    'button[aria-label*="Toggle run settings" i]',
    'button[aria-label*="Run settings" i]',
    'button[mattooltip*="Run settings" i]',
    'button:has(span.material-symbols-outlined:has-text("tune"))',
    'button:has(mat-icon:has-text("tune"))',
  ],

  /** Model selector card / dropdown trigger at top of Run Settings panel */
  modelSelectorTrigger: [
    'ms-model-selector button',
    'ms-model-selector .model-selector-card',
    'ms-model-selector mat-select',
    'ms-model-selector',
    '[data-test-id="model-selector"]',
    '[data-test-id*="model-selector" i]',
    'button[aria-label*="Select model" i]',
    'button[aria-label*="Model selector" i]',
    'mat-select[aria-label*="Model" i]',
    '.model-selector-trigger',
    '.model-selector-card',
  ],

  /** Model search input or option list inside model picker */
  modelSearchInput: [
    'input[placeholder*="Search for a model" i]',
    'input[placeholder*="Search models" i]',
    'input[aria-label*="Search for a model" i]',
    'input[aria-label*="Search models" i]',
    'input[placeholder*="Search" i]',
    '.mat-mdc-select-panel input',
  ],

  /** Temperature input box (numeric input next to slider) */
  temperatureInput: [
    'input[aria-label*="Temperature" i]',
    'ms-slider[label*="Temperature" i] input[type="number"]',
    '[data-test-id*="temperature" i] input[type="number"]',
    'mat-slider[aria-label*="Temperature" i] ~ input',
    'div:has(> label:has-text("Temperature")) input[type="number"]',
  ],

  /** Thinking mode toggle switch */
  thinkingToggle: [
    'mat-slide-toggle[aria-label*="Thinking" i] button[role="switch"]',
    '[data-test-id*="thinking-toggle" i] button[role="switch"]',
  ],

  /** Thinking level / budget dropdown trigger */
  thinkingLevelSelect: [
    'mat-select[aria-label*="Thinking level" i]',
    'mat-select[aria-label*="Thinking" i]',
    '[role="combobox"][aria-label*="Thinking level" i]',
    '[role="combobox"][aria-label*="Thinking" i]',
    'button[aria-label*="Thinking level" i]',
    '[data-test-id*="thinking-level" i] mat-select',
    '[data-test-id*="thinking-level" i] [role="combobox"]',
    '[data-test-id*="thinking-level" i] button',
    '[data-test-id*="thinking-level" i]',
    'mat-form-field:has-text("Thinking level") mat-select',
    'mat-form-field:has-text("Thinking") mat-select',
  ],

  /** Advanced settings accordion inside Run Settings */
  advancedSettingsToggle: [
    'button:has-text("Advanced settings")',
    'mat-expansion-panel-header:has-text("Advanced settings")',
    '[aria-label*="Advanced settings" i]',
  ],

  /** Safety settings button that opens the safety modal */
  safetySettingsTrigger: [
    'button:has-text("Edit safety settings")',
    'button[aria-label*="Safety settings" i]',
    '[data-test-id*="safety-settings" i] button',
  ],

  /** Inside Safety settings modal: sliders or Off buttons */
  safetySliders: [
    'mat-dialog-container input[type="range"]',
    'mat-dialog-container mat-slider input',
    '.safety-settings-dialog input[type="range"]',
  ],

  safetyOffButtons: [
    'mat-dialog-container button:has-text("Off")',
    'mat-dialog-container mat-button-toggle:has-text("Off") button',
    'mat-dialog-container mat-option:has-text("Block none")',
  ],

  safetyModalClose: [
    'mat-dialog-container button:has-text("Save")',
    'mat-dialog-container button:has-text("Done")',
    'mat-dialog-container button[aria-label*="Close" i]',
    'mat-dialog-container button:has-text("Close")',
  ],

  /** Max output tokens input in Advanced Settings */
  maxOutputTokensInput: [
    'input[aria-label*="Output length" i]',
    'input[aria-label*="Output token" i]',
    'input[aria-label*="Max output" i]',
    '[data-test-id*="output-length" i] input',
    'div:has(> label:has-text("Output length")) input',
  ],

  /** Media resolution dropdown in Run Settings (Low = ~65 tokens/frame) */
  mediaResolutionSelect: [
    'mat-select[aria-label*="Media resolution" i]',
    '[role="combobox"][aria-label*="Media resolution" i]',
    '[data-test-id*="media-resolution" i] mat-select',
    '[data-test-id*="media-resolution" i] [role="combobox"]',
    'mat-form-field:has-text("Media resolution") mat-select',
    'button[aria-label*="Media resolution" i]',
  ],

  /** Insert (+) button in prompt composer to attach media */
  insertMediaButton: [
    'ms-add-chunk-menu button',
    'button[aria-label*="Insert assets" i]',
    'button[aria-label*="Insert" i]',
    'button[aria-label*="Add media" i]',
    'button[aria-label*="Add to prompt" i]',
    'button[mattooltip*="Insert" i]',
    '.prompt-input-wrapper button:has(mat-icon:has-text("add"))',
    'button:has(span.material-symbols-outlined:has-text("add_circle"))',
    'button:has(span.material-symbols-outlined:has-text("add"))',
  ],

  /** Menu options inside the Insert (+) menu */
  insertMenuYoutubeOption: [
    'button[role="menuitem"]:has-text("YouTube")',
    '[role="menuitem"]:has-text("YouTube Video")',
    'button:has-text("YouTube URL")',
    'button:has-text("YouTube")',
  ],

  insertMenuDriveOption: [
    'button[role="menuitem"]:has-text("Google Drive")',
    '[role="menuitem"]:has-text("My Drive")',
    '[role="menuitem"]:has-text("Drive")',
    'button:has-text("Google Drive")',
    'button:has-text("Drive")',
  ],

  insertMenuUploadFileOption: [
    'button[role="menuitem"]:has-text("Upload File")',
    'button[role="menuitem"]:has-text("Upload")',
    '[role="menuitem"]:has-text("Upload")',
    'input[type="file"]',
  ],

  /** YouTube URL modal / input when "YouTube Video" is clicked */
  youtubeModalInput: [
    'mat-dialog-container input[type="url"]',
    'mat-dialog-container input[type="text"]',
    'input[placeholder*="youtube.com" i]',
    'input[aria-label*="YouTube" i]',
  ],

  youtubeModalConfirm: [
    'mat-dialog-container button:has-text("Insert")',
    'mat-dialog-container button:has-text("Add")',
    'mat-dialog-container button:has-text("Save")',
    'mat-dialog-container button[type="submit"]',
  ],

  /** Google Drive Picker iframe */
  drivePickerIframe: [
    'iframe[src*="docs.google.com/picker"]',
    'iframe[name*="picker" i]',
    'iframe[src*="drive.google.com"]',
  ],

  /** Inside Google Drive Picker iframe: search box, file item, select button */
  drivePickerSearchInput: [
    'input[aria-label*="Search" i]',
    'input[placeholder*="Search" i]',
    'input[type="text"]',
  ],

  drivePickerSelectButton: [
    'div[role="button"]:has-text("Select")',
    'button:has-text("Select")',
    'div[role="button"]:has-text("Insert")',
    '[aria-label="Select" i]',
  ],

  /** Attached video chips in the prompt composer — valid standard CSS only (safe for document.querySelectorAll) */
  videoMediaChipsCss: [
    'ms-media-chunk',
    'ms-video-chunk',
    'ms-youtube-chunk',
    'ms-chunk-chip',
    'ms-prompt-chunk',
    'ms-file-chunk',
    'ms-drive-chunk',
    '[data-test-id*="media-chunk" i]',
    '[data-test-id*="chunk-chip" i]',
    '[data-test-id*="prompt-chunk" i]',
    '.media-chip',
  ],

  /** Attached video chips — Playwright-only selectors (:has-text) */
  videoMediaChipsPw: [
    '.chunk-chip:has-text(".mp4")',
    '.chunk-chip:has-text("youtube")',
  ],

  /** Attached video chips in the prompt composer (combined CSS + Playwright) */
  videoMediaChips: [
    'ms-media-chunk',
    'ms-video-chunk',
    'ms-youtube-chunk',
    'ms-chunk-chip',
    'ms-prompt-chunk',
    'ms-file-chunk',
    'ms-drive-chunk',
    '[data-test-id*="media-chunk" i]',
    '[data-test-id*="chunk-chip" i]',
    '[data-test-id*="prompt-chunk" i]',
    '.media-chip',
    '.chunk-chip:has-text(".mp4")',
    '.chunk-chip:has-text("youtube")',
  ],

  /** Video settings / clip range / FPS (gear) button on a video chip */
  videoChipSettingsButton: [
    'button[aria-label="Edit video options" i]',
    'button[aria-label*="Edit video options" i]',
    'button[aria-label*="Video options" i]',
    'button[aria-label*="Video settings" i]',
    'button[aria-label*="Media settings" i]',
    'button[aria-label*="Edit video" i]',
    'button[aria-label*="Clip settings" i]',
    'button[aria-label*="Configure" i]',
    'button[aria-label*="Settings" i]',
    'button[mattooltip*="settings" i]',
    'button[mattooltip*="video" i]',
    'button[title*="settings" i]',
    'button:has(mat-icon:has-text("settings"))',
    'button:has(mat-icon:has-text("tune"))',
    'button:has(mat-icon:has-text("video_settings"))',
    'button:has(mat-icon[fonticon="settings"])',
    'button:has(mat-icon[fonticon="tune"])',
    'button:has(span.material-symbols-outlined:has-text("settings"))',
    'button:has(span.material-symbols-outlined:has-text("tune"))',
    'button:has(span.google-symbols:has-text("settings"))',
    'button:has(span.google-symbols:has-text("tune"))',
    'button:has(span:has-text("settings"))',
    'button:has(span:has-text("tune"))',
    '[role="button"][aria-label*="Edit video options" i]',
    '[role="button"][aria-label*="settings" i]',
  ],

  /** Inside Video Settings popover/dialog: Start time, End time, FPS inputs */
  videoStartTimeInput: [
    '[data-cmt-video-input="start"]',
    'input[aria-label*="Start time" i]',
    'input[aria-label*="Start offset" i]',
    'input[aria-label*="Start" i]',
    'mat-form-field:has-text("Start Time") input',
    'mat-form-field:has-text("Start") input',
    'div:has(> label:has-text("Start Time")) input',
    'div:has(> label:has-text("Start")) input',
    'div:has(> span:has-text("Start Time")) input',
    'div:has(> span:has-text("Start")) input',
    'label:has-text("Start") input',
    ':nth-match(mat-dialog-container input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), 1)',
    ':nth-match([role="dialog"] input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), 1)',
    ':nth-match(.cdk-overlay-pane input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), 1)',
    '.video-settings-container input:nth-of-type(1)',
  ],

  videoEndTimeInput: [
    '[data-cmt-video-input="end"]',
    'input[aria-label*="End time" i]',
    'input[aria-label*="End offset" i]',
    'input[aria-label*="End" i]',
    'mat-form-field:has-text("End Time") input',
    'mat-form-field:has-text("End") input',
    'div:has(> label:has-text("End Time")) input',
    'div:has(> label:has-text("End")) input',
    'div:has(> span:has-text("End Time")) input',
    'div:has(> span:has-text("End")) input',
    'label:has-text("End") input',
    ':nth-match(mat-dialog-container input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), 2)',
    ':nth-match([role="dialog"] input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), 2)',
    ':nth-match(.cdk-overlay-pane input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), 2)',
    '.video-settings-container input:nth-of-type(2)',
  ],

  videoFpsInput: [
    '[data-cmt-video-input="fps"]',
    'input[placeholder*="Defaults to 1 FPS" i]',
    'input[placeholder*="FPS" i]',
    'input[aria-label*="FPS" i]',
    'input[aria-label*="Frame rate" i]',
    'input[aria-label*="frames per second" i]',
    'input[aria-label*="Sampling" i]',
    'input[type="number"][aria-label*="frame" i]',
    'mat-form-field:has-text("FPS") input',
    'mat-form-field:has-text("Frame") input',
    'div:has(> label:has-text("FPS")) input',
    'div:has(> label:has-text("Frame")) input',
    'div:has(> span:has-text("FPS")) input',
    'label:has-text("FPS") input',
    ':nth-match(mat-dialog-container input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), 3)',
    ':nth-match([role="dialog"] input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), 3)',
    ':nth-match(.cdk-overlay-pane input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), 3)',
    '.video-settings-container input[type="number"]',
  ],

  videoSettingsSaveButton: [
    '[data-cmt-video-save="true"]',
    'mat-dialog-container button:has-text("Save")',
    '[role="dialog"] button:has-text("Save")',
    '.cdk-overlay-pane button:has-text("Save")',
    'button[aria-label*="Save video settings" i]',
    'mat-dialog-container button:has-text("Apply")',
    'mat-dialog-container button:has-text("Done")',
    'mat-dialog-container button:has-text("Confirm")',
    '[role="dialog"] button:has-text("Apply")',
    '[role="dialog"] button:has-text("Done")',
    '.cdk-overlay-pane button:has-text("Apply")',
    '.cdk-overlay-pane button:has-text("Done")',
  ],

  /** Token count display in Studio header / Run button area */
  tokenCountContainers: [
    'ms-token-count',
    '[data-test-id*="token-count" i]',
    '.token-count',
    'span:has-text("tokens")',
  ],

  /** Prompt text input area */
  promptInput: [
    'ms-autosize-textarea textarea',
    'textarea[aria-label*="Type something" i]',
    'textarea[placeholder*="Type something" i]',
    'textarea[aria-label*="prompt" i]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea',
  ],

  /** Run / Stop button */
  runButton: [
    'ms-run-button button',
    'button.run-button',
    'button[aria-label*="Run" i]',
    'button:has-text("Run")',
  ],

  stopButton: [
    'button[aria-label*="Stop" i]',
    'ms-run-button button:has-text("Stop")',
    'button.stop-button',
  ],

  /** Thinking / running spinner (strictly scoped to model turn or Run-Stop button, no page-wide generic mat-spinner) */
  runningSpinners: [
    'ms-chat-turn mat-spinner',
    'ms-chat-turn mat-progress-spinner',
    'ms-chat-turn [role="progressbar"]',
    'ms-thought-chunk mat-spinner',
    'ms-thought-chunk mat-progress-spinner',
    'ms-thought-chunk [role="progressbar"]',
    'ms-run-button mat-spinner',
    'ms-run-button mat-progress-spinner',
    'ms-run-button [role="progressbar"]',
    'button.run-button mat-spinner',
    'button.run-button mat-progress-spinner',
  ],

  /** Three-dot / more_vert options button INSIDE the last model turn */
  turnOptionsButton: [
    'button:has(mat-icon:text("more_vert"))',
    'button:has(.material-symbols-outlined:text("more_vert"))',
    'button[aria-label*="Turn options" i]',
    'button[aria-label*="More options" i]',
    'button[aria-label*="options" i]',
    'button[aria-label*="more" i]',
    'button:has-text("more_vert")',
  ],

  /** "Copy as text" item inside the CDK overlay menu opened from the turn options button */
  copyAsTextMenuItem: [
    '.cdk-overlay-container [role="menuitem"]:has-text("Copy as text")',
    '.cdk-overlay-container button:has-text("Copy as text")',
    '.cdk-overlay-container .mat-mdc-menu-item:has-text("Copy as text")',
    '[role="menu"] [role="menuitem"]:has-text("Copy as text")',
    '[role="menuitem"]:has-text("Copy as text")',
  ],

  /** Top page header three-dot buttons that MUST NEVER be clicked when copying a turn */
  headerMoreButtonToExclude: [
    'header button[aria-label*="more" i]',
    'mat-toolbar button[aria-label*="more" i]',
    'ms-toolbar button[aria-label*="more" i]',
    '.toolbar button[aria-label*="more" i]',
    'header button:has-text("more_vert")',
    'mat-toolbar button:has-text("more_vert")',
    'ms-header button',
  ],

  /** Strict Error / Quota / Rate Limit / Safety Block alert containers only */
  errorBanners: [
    '[role="alert"]',
    'ms-error-banner',
    '.error-banner',
    '.mat-mdc-snack-bar-container [role="alert"]',
    '.mat-mdc-snack-bar-label',
  ],

  /** Model response turn containers (last one is the latest answer) */
  modelTurnContainers: [
    'ms-chat-turn[role="model"]',
    'ms-chat-turn:has(.model-prompt-container)',
    '[data-turn-role="model"]',
    '.model-turn',
    'ms-chat-turn',
  ],

  /** Thinking / Thought containers inside a model turn (MUST BE EXCLUDED when copying final answer) */
  thoughtContainersToExclude: [
    'ms-thought-chunk',
    '[data-test-id*="thought" i]',
    '.thought-container',
    '.thinking-block',
    'mat-expansion-panel:has-text("Thoughts")',
    'details:has(summary:has-text("Thinking"))',
  ],

  /** Final answer markdown/text container inside a model turn */
  modelAnswerContent: [
    'ms-text-chunk ms-cmark-node',
    'ms-cmark-node',
    '.turn-content',
    '.markdown-content',
  ],
} as const

/**
 * Helper to find the first visible matching Locator from a selector list.
 */
export async function findFirstVisibleLocator(
  root: Page | Frame,
  selectors: readonly string[],
  timeoutMs: number = 3000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = root.locator(sel).first()
        if ((await loc.count()) > 0 && (await loc.isVisible())) {
          return loc
        }
      } catch {
        /* try next selector */
      }
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}

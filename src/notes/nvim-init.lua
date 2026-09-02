-- Minimal, dependency-free configuration for the VM-local Notes workspace.
-- This file intentionally defines no shell mappings and loads no plugins.
vim.g.mapleader = " "
vim.g.maplocalleader = " "
vim.cmd("filetype plugin indent on")
vim.opt.number = true
vim.opt.cursorline = true
vim.opt.signcolumn = "yes"
vim.opt.termguicolors = true
vim.opt.splitright = true
vim.opt.hidden = true
-- checktime never discards a modified buffer: Neovim reports the conflict and
-- leaves human edits intact. autoread only reloads buffers that are unmodified.
vim.opt.autoread = true

vim.g.netrw_banner = 1
vim.g.netrw_liststyle = 3
vim.g.netrw_winsize = 25

vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter", "CursorHold", "CursorHoldI" }, {
  callback = function()
    -- Never invoke checktime for a dirty buffer: an external-change prompt
    -- would block the viewer until a human answers it.
    if vim.bo.buftype == "" and not vim.bo.modified then vim.cmd("silent! checktime") end
  end,
  desc = "Notes: detect external changes without replacing dirty edits",
})

-- Small RPC helpers used by Pi. They are expressions rather than remote key
-- presses, so Pi receives an acknowledgement and can report conflicts.
_G.pi_notes_refresh = function()
  local buffer = vim.api.nvim_get_current_buf()
  if vim.bo[buffer].modified then return "dirty" end
  vim.schedule(function()
    if not vim.bo[buffer].modified then pcall(vim.cmd, "silent! checktime") end
  end)
  return "scheduled"
end

_G.pi_notes_save = function()
  local buffer = vim.api.nvim_get_current_buf()
  if vim.bo[buffer].readonly or not vim.bo[buffer].modifiable then return "read_only" end
  local ok, error_message = pcall(vim.cmd, "update")
  if not ok then return "error:" .. tostring(error_message) end
  return vim.bo[buffer].modified and "not_saved" or "saved"
end

vim.api.nvim_create_user_command("NotesHelp", function()
  vim.cmd("enew")
  vim.bo.buftype = "nofile"
  vim.bo.bufhidden = "wipe"
  vim.bo.swapfile = false
  vim.bo.modifiable = true
  vim.api.nvim_buf_set_lines(0, 0, -1, false, {
    "Notes workspace",
    "===============",
    "",
    "<leader>e   Open the folder explorer",
    "<leader>r   Check files changed by Pi without replacing dirty edits",
    "<leader>w   Save the current note and report errors",
    "<leader>b   List buffers",
    "<leader>?   Show this help",
    ":Explore    Open the current directory",
    ":checktime  Detect changes on disk safely",
    ":bd        Close the current buffer",
    ":q         Close the current window",
    "",
    "Press q or :bd to close this help buffer.",
  })
  vim.bo.modifiable = false
  vim.bo.filetype = "help"
end, {})

vim.keymap.set("n", "<leader>e", "<cmd>Explore<cr>", { desc = "Notes: explore" })
vim.keymap.set("n", "<leader>r", "<cmd>checktime<cr>", { desc = "Notes: refresh" })
vim.keymap.set("n", "<leader>w", "<cmd>update<cr>", { desc = "Notes: save" })
vim.keymap.set("n", "<leader>b", "<cmd>buffers<cr>", { desc = "Notes: buffers" })
vim.keymap.set("n", "<leader>?", "<cmd>NotesHelp<cr>", { desc = "Notes: help" })

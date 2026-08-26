-- Minimal, dependency-free configuration for the VM-local Notes workspace.
-- This file intentionally defines no shell mappings and loads no plugins.
vim.cmd("filetype plugin indent on")
vim.opt.number = true
vim.opt.cursorline = true
vim.opt.signcolumn = "yes"
vim.opt.termguicolors = true
vim.opt.splitright = true
vim.opt.hidden = true

vim.g.netrw_banner = 1
vim.g.netrw_liststyle = 3
vim.g.netrw_winsize = 25

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
    "<leader>r   Refresh files changed by Pi",
    "<leader>w   Save the current note",
    "<leader>b   List buffers",
    "<leader>?   Show this help",
    ":Explore    Open the current directory",
    ":checktime  Detect changes on disk",
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

# Jouzu

This Python package reserves the `jouzu` name. It does not run the Jouzu coding
agent. Install the coding agent from [npm](https://www.npmjs.com/package/jouzu):

```bash
npm install -g jouzu
```

See the [Jouzu installation guide](https://github.com/shisa-ai/jouzu#install)
for requirements and setup.

The Python package provides `jouzu` and `jz` commands that print a reservation
notice. `jouzu --version` prints the package version. `jouzu doctor` emits JSON
with the package name, version, `package-name-reservation` status, Python version,
operating system, and architecture.

The Python and npm packages use the same command names. If you installed this
reservation package, uninstall it before installing the npm package to avoid
command-name conflicts.

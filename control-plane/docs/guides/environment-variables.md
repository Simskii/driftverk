# Environment variables

Use variables for runtime configuration in trusted environments. Driftverk encrypts values before storing them, then injects them into the environment. Code running there can read them.

## Add configuration

An administrator can add variables during creation or from the environment detail page. Names use letters, numbers and underscores, and cannot start with a number.

```dotenv
NODE_ENV=development
LOG_LEVEL=debug
```

Untrusted environments cannot receive these values. Do not give production credentials to development or pull request code.

## Rotate and remove values

Save a new value under the same name to replace it, or delete the saved variable. Saved changes apply to new terminal and SSH sessions. Existing processes and values set at container creation remain unchanged.

Replace the environment to remove original container values fully. Revoke or rotate the credential at its issuing service when access must end.

## Reuse without copying secrets

Use a clean prebuild and add variables separately to each new environment. A snapshot can retain variables already present in the container, as well as secrets written to files. Snapshot only when copying those values is intentional.

See [Project setup](/docs/project-setup) for the prebuild and initialization sequence.

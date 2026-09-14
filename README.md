# Setup Erlang/OTP

This repository contains a JavaScript action to setup Erlang/OTP in your Github
Actions workflows. It detects the platform of your runners and install a
pre-built version of Erlang/OTP accordingly.

```yaml
- uses: erlangsters/setup-erlang-otp@v1
  with:
    erlang-version: 27
    install-rebar3: true
```

Additionally, you may also request the action to install the
[rebar3](https://rebar3.org/) script.

Written by the Erlangsters [community](https://about.erlangsters.org/) and
released under the MIT [license](/https://opensource.org/license/mit).

## Binaries provenance

The pre-built binaries used by this action are the ones maintained by the
Erlangsters community and therefore it supports Linux, macOS and Windows. See
the [Erlang/OTP builder](https://github.com/erlangsters/build-erlang-otp) for more
information.

## Basic usage

No input is required to use this action and therefore the most basic usage is
the following.

```yaml
- uses: erlangsters/setup-erlang-otp@v1
```

It will simply use the latest version of Erlang/OTP and install just that.

Of course, you may specify an Erlang version with the `erlang-version` input
field.

```yaml
- uses: erlangsters/setup-erlang-otp@v1
  with:
    erlang-version: 27
```

In this example, it will use the latest version 27.x that exists but you may
give an even more specific version.

## Advanced usage

There really is nothing more to this action other than the possibility to
install the `rebar3` script.

```yaml
- uses: erlangsters/setup-erlang-otp@v1
  with:
    install-rebar3: true
```

The `install-rebar3` input field is optional and defaults to `false`.

## Supported platforms

Like stated, it does not build Erlang/OTP and instead use pre-built binaries
that are provided by the Erlangsters community. That implies that the supported
platforms derived from their policy.

The catalog is the latest patch of each remaining major:

- Erlang/OTP 29.0.6
- Erlang/OTP 28.5.0.6
- Erlang/OTP 27.3.4.17

`erlang-version: 27` installs 27.3.4.17. OTP 25 and 26 are not shipped.

| Artifact | Built on | libc | Run on | Do not run on |
|---|---|---|---|---|
| `debian-amd64`, `debian-arm64` | `debian:12` | glibc 2.36 | Debian 12+, Ubuntu 24.04+, Debian 13 | Ubuntu 22.04 (glibc 2.35), Debian 11 |
| `alpine-amd64` | `alpine:3.23` | musl 1.2.5 | Alpine 3.23 | Alpine 3.24, `alpine:3`, musl 1.2.6 |
| `macos-arm64` | `macos-26` | — | current macOS arm64 runners | Intel Mac |
| `windows-amd64` | `windows-2022` | — | that runner | — |

If you're confused about what "glibc" and "musl" are, they are the C libraries
used system-wide. Most Linux distros use the "GNU C Library"; however, distros
like Alpine use musl, which has a smaller footprint.

Musl trees are Alpine 3.23 only. OTP 26 and later abort on musl 1.2.6 with
`sys_sigaltstack(): Failed to set alternate signal stack`, because official OTP
still uses a compile-time `SIGSTKSZ`. The trees are dynamically linked, so a
3.23 build is not safe on 3.24. On musl 1.2.6 this action refuses to install
rather than hand you a beam that SIGABRTs. Pin the job container to
`alpine:3.23`.

> **Note:** There is currently a limitation with GitHub Actions where Alpine ARM64
> runners do not support JavaScript actions. Until GitHub adds this support,
> this action cannot be used on Linux arm64/musl (Alpine) systems.

## Dummy applications

What's with the `dummy-release/` and `dummy-escript/` folders in this
repository? Well, they're real-life Erlang applications that are used by the
Github Actions [workflow](.github/workflows/setup-erlang-otp.yml) to test the
`setup-erlang-otp` action against them.

The `dummy-release/` folder contains an OTP release which uses the popular
[cowboy](https://ninenines.eu/docs/en/cowboy/2.12/guide/) framework to
implement a basic HTTP server that runs locally. It exposes the `/hello`
endpoint which takes a "name" and will reply with "Hello \<name\>!".

The `dummy-escript/` folder on the other side contains an Erlang script, or
"escript", that uses the popular
[gun](https://ninenines.eu/docs/en/gun/2.1/guide/) library to make a HTTP
request to that previous `/hello` endpoint. It takes the name as argument.

You got it, they're meant to be used together to test if the applications not
only build successfully, but also runs flawlessly (after they're distributed,
on a different machine).

## More examples

Distributing cross-platform Erlang applications can be a pain. That's why
setting up proper CI/CD from the start of your project is important.

To help with this task, you can consult
[those examples](https://github.com/erlangsters/setup-erlang-examples) which
use this Github action, and get inspiration.

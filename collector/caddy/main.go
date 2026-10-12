// Copyright 2015 Matthew Holt and The Caddy Authors
// SPDX-License-Identifier: Apache-2.0
// Standard Caddy entrypoint, following https://caddyserver.com/docs/build.
package main

import (
	_ "time/tzdata"

	caddycmd "github.com/caddyserver/caddy/v2/cmd"
	_ "github.com/caddyserver/caddy/v2/modules/standard"
)

func main() { caddycmd.Main() }

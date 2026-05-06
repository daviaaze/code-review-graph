{
  description = "code-review-graph — MCP semantic code search + pi agent extension (NixOS)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      # Shared overlay for Python package fixes
      pythonFixesOverlay = final: prev: {
        python312Packages = prev.python312Packages.overrideScope (pyFinal: pyPrev: {
          # Inquirer's acceptance tests use pexpect with terminal
          # interactions and timeout in the Nix sandbox. Skip them.
          inquirer = pyPrev.inquirer.overridePythonAttrs (old: {
            doCheck = false;
          });
          fastmcp = pyPrev.fastmcp.overridePythonAttrs (old: {
            doCheck = false;
          });
        });
      };

      # Pi extension package builder
      mkPiExtension = pkgs: pkgs.stdenvNoCC.mkDerivation {
        pname = "pi-code-review-graph";
        version = "0.1.0";
        src = ./pi-extension;
        installPhase = ''
          mkdir -p $out/share/pi-code-review-graph
          cp -r * $out/share/pi-code-review-graph/
        '';
        meta = {
          description = "Pi agent extension bridging to code-review-graph MCP server";
          license = pkgs.lib.licenses.mit;
        };
      };
    in
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ pythonFixesOverlay ];
        };

        # The main code-review-graph Python application (from local fork)
        codeReviewGraph = pkgs.python312Packages.buildPythonApplication rec {
          pname = "code-review-graph";
          version = "2.3.2-patched";
          pyproject = true;

          src = ./.;

          build-system = with pkgs.python312Packages; [ hatchling ];

          dependencies = with pkgs.python312Packages; [
            fastmcp
            mcp
            networkx
            tree-sitter
            tree-sitter-language-pack
            watchdog
          ];

          # The package shells out to `git` via subprocess in
          # changes.py and incremental.py. Wrap the binary so git
          # is available at runtime regardless of user environment.
          makeWrapperArgs = [
            "--prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git ]}"
          ];

          nativeBuildInputs = with pkgs; [
            makeWrapper
          ] ++ (with pkgs.python312Packages; [
            pythonRelaxDepsHook
          ]);

          pythonRelaxDeps = [
            "tree-sitter-language-pack"
            "watchdog"
            "fastmcp"
          ];

          doCheck = false;

          meta = {
            description = "Persistent incremental knowledge graph for token-efficient, context-aware code reviews";
            homepage = "https://code-review-graph.com";
            license = pkgs.lib.licenses.mit;
            mainProgram = "code-review-graph";
          };
        };

        piExtension = mkPiExtension pkgs;

      in
      {
        packages = {
          default = codeReviewGraph;
          code-review-graph = codeReviewGraph;
          pi-extension = piExtension;
        };

        devShells.default = pkgs.mkShell {
          name = "code-review-graph-shell";

          inputsFrom = [ codeReviewGraph ];

          packages = with pkgs; [
            git
            uv
          ];

          shellHook = ''
            echo ""
            echo "=========================================="
            echo " ✅ code-review-graph dev shell"
            echo ""
            echo " Package: $(code-review-graph --version 2>/dev/null || echo 'not in PATH')"
            echo ""
            echo " Available commands:"
            echo "   code-review-graph build        # Build the knowledge graph"
            echo "   code-review-graph serve        # Start MCP server (stdio)"
            echo "   code-review-graph serve --http # Start MCP server (HTTP)"
            echo "   code-review-graph status       # Check graph status"
            echo ""
            echo " Pi extension:"
            echo "   cp -r ${piExtension}/share/pi-code-review-graph ~/.pi/agent/extensions/"
            echo "   pi /reload"
            echo "=========================================="
            echo ""
          '';
        };
      })
    // {
      # ── NixOS Module ──────────────────────────────────────────────────────
      #
      # Usage in configuration.nix:
      #   imports = [ inputs.code-review-graph.nixosModules.default ];
      #   services.code-review-graph = {
      #     enable = true;
      #     repositories = [ /home/user/projects/my-app ];
      #     mcpServer.enable = true;
      #     autoBuild.enable = true;
      #   };
      #
      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.code-review-graph;
          system = pkgs.system;
        in
        {
          options.services.code-review-graph = {
            enable = lib.mkEnableOption "code-review-graph MCP server and auto-build hooks";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${system}.default;
              description = "The code-review-graph package to use.";
            };

            repositories = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [];
              description = "List of repository paths to auto-build and watch.";
            };

            mcpServer = {
              enable = lib.mkEnableOption "MCP server auto-start via systemd user service";

              transport = lib.mkOption {
                type = lib.types.enum [ "stdio" "http" ];
                default = "stdio";
                description = "MCP transport mode. stdio is for pi extension, http for external tools.";
              };

              port = lib.mkOption {
                type = lib.types.port;
                default = 8080;
                description = "HTTP port when transport is http.";
              };

              host = lib.mkOption {
                type = lib.types.str;
                default = "127.0.0.1";
                description = "HTTP host when transport is http.";
              };
            };

            autoBuild = {
              enable = lib.mkEnableOption "automatic graph rebuild on file changes";

              onBoot = lib.mkOption {
                type = lib.types.bool;
                default = true;
                description = "Build graph on service startup.";
              };

              watchFiles = lib.mkOption {
                type = lib.types.bool;
                default = true;
                description = "Watch files for changes and auto-update graph.";
              };
            };
          };

          config = lib.mkIf cfg.enable {
            environment.systemPackages = [ cfg.package ];

            # Systemd user service for MCP server
            systemd.user.services.code-review-graph-mcp = lib.mkIf cfg.mcpServer.enable {
              description = "code-review-graph MCP server";
              after = [ "network.target" ];
              serviceConfig = {
                Type = "simple";
                ExecStart = lib.concatStringsSep " " ([
                  "${cfg.package}/bin/code-review-graph"
                  "serve"
                ] ++ lib.optionals (cfg.mcpServer.transport == "http") [
                  "--http"
                  "--host" cfg.mcpServer.host
                  "--port" (toString cfg.mcpServer.port)
                ]);
                Restart = "on-failure";
                RestartSec = 5;
              };
              wantedBy = [ "default.target" ];
            };

            # Auto-build on boot for each repository
            systemd.user.services.code-review-graph-build = lib.mkIf (cfg.autoBuild.enable && cfg.autoBuild.onBoot) {
              description = "Build code-review-graph for configured repositories";
              after = [ "network.target" ];
              serviceConfig = {
                Type = "oneshot";
                ExecStart = pkgs.writeShellScript "crg-build-all" ''
                  set -e
                  ${lib.concatMapStringsSep "\n" (repo: ''
                    echo "Building graph for ${repo}..."
                    cd ${repo}
                    ${cfg.package}/bin/code-review-graph build || true
                  '') cfg.repositories}
                '';
              };
              wantedBy = [ "default.target" ];
            };

            # File watcher service for auto-updates
            systemd.user.services.code-review-graph-watch = lib.mkIf (cfg.autoBuild.enable && cfg.autoBuild.watchFiles) {
              description = "Watch files and auto-update code-review-graph";
              after = [ "code-review-graph-build.service" ];
              serviceConfig = {
                Type = "simple";
                ExecStart = pkgs.writeShellScript "crg-watch" ''
                  set -e
                  ${lib.concatMapStringsSep "\n" (repo: ''
                    cd ${repo}
                    ${cfg.package}/bin/code-review-graph watch &
                  '') cfg.repositories}
                  wait
                '';
                Restart = "on-failure";
              };
              wantedBy = [ "default.target" ];
            };
          };
        };

      # ── Home Manager Module ───────────────────────────────────────────────
      #
      # Usage in home.nix:
      #   imports = [ inputs.code-review-graph.homeManagerModules.default ];
      #   programs.pi.code-review-graph = {
      #     enable = true;
      #     installExtension = true;
      #   };
      #
      homeManagerModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.programs.pi.code-review-graph;
          system = pkgs.system;
        in
        {
          options.programs.pi.code-review-graph = {
            enable = lib.mkEnableOption "code-review-graph integration for pi agent";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${system}.default;
              description = "The code-review-graph package to use.";
            };

            installExtension = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Install the pi extension to ~/.pi/agent/extensions/";
            };

            extensionPackage = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${system}.pi-extension;
              description = "The pi extension package to install.";
            };

            autoStartMcp = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Auto-start MCP server when pi starts (via extension).";
            };

            repositories = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [];
              description = "Repositories to build graphs for on activation.";
            };
          };

          config = lib.mkIf cfg.enable {
            home.packages = [ cfg.package ];

            # Install pi extension
            home.file = lib.mkIf cfg.installExtension {
              ".pi/agent/extensions/code-review-graph.ts".source =
                "${cfg.extensionPackage}/share/pi-code-review-graph/code-review-graph.ts";
            };

            # Auto-build graphs for configured repositories
            home.activation.codeReviewGraphBuild = lib.mkIf (cfg.repositories != []) (
              lib.hm.dag.entryAfter [ "writeBoundary" ] ''
                $DRY_RUN_CMD echo "Building code-review-graph for configured repositories..."
                ${lib.concatMapStringsSep "\n" (repo: ''
                  if [ -d "${repo}" ]; then
                    $DRY_RUN_CMD cd "${repo}" && ${cfg.package}/bin/code-review-graph build 2>/dev/null || true
                  fi
                '') cfg.repositories}
              ''
            );
          };
        };
    };
}

{
  description = "Muriel - a desktop audio player (Electron)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    let
      mkMuriel = pkgs:
        pkgs.buildNpmPackage rec {
          pname = "muriel";
          version = "42.0.0";
          src = self;

          npmDepsHash = "sha256-fptxs7GYEi3F9BTI6amByNVcX28QElIE6e0baFr4WzI=";

          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          forceGitDeps = true;
          npmInstallFlags = [ "--omit=dev" ];

          buildPhase = "true";

          installPhase =
            let
              appDir = "$out/share/muriel";
              runtimeDeps = pkgs.lib.makeBinPath [ pkgs.yt-dlp pkgs.ffmpeg ];
              desktop = pkgs.makeDesktopItem {
                name = "Muriel";
                desktopName = "Muriel";
                genericName = "Audio Player";
                exec = "muriel";
                icon = "muriel";
                categories = [ "AudioVideo" "Audio" "Player" ];
                startupWMClass = "muriel";
              };
            in
            ''
              runHook preInstall

              mkdir -p ${appDir}
              for f in *; do cp -r "$f" ${appDir}/; done

              mkdir -p $out/bin
              makeWrapper ${pkgs.electron}/bin/electron $out/bin/muriel \
                --add-flags ${appDir} \
                --prefix PATH : ${runtimeDeps}

              mkdir -p $out/share/applications
              cp ${desktop}/share/applications/*.desktop $out/share/applications/

              mkdir -p $out/share/icons/hicolor/256x256/apps
              cp ${appDir}/assets/icon.png $out/share/icons/hicolor/256x256/apps/muriel.png

              runHook postInstall
            '';

          meta = with pkgs.lib; {
            description = "Muriel - audio player made for humans";
            homepage = "https://github.com/cloverscripts/riff-muriel";
            license = licenses.mit;
            mainProgram = "muriel";
            platforms = platforms.linux ++ platforms.darwin;
          };
        };
    in
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages = {
          default = mkMuriel pkgs;
          muriel = mkMuriel pkgs;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs
            python3
            yt-dlp
            ffmpeg
          ];

          shellHook = ''
            echo "Muriel dev shell. Install deps and run with:"
            echo "  npm install && npm start"
          '';
        };
      })
    // {
      overlays.default = final: prev: {
        muriel = mkMuriel final;
      };
    };
}

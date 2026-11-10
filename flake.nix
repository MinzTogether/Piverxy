{
  description = "Piverxy - a desktop audio player (Electron)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    let
      mkPiverxy = pkgs:
        pkgs.buildNpmPackage rec {
          pname = "piverxy";
          version = "42.0.0";
          src = self;

          npmDepsHash = "sha256-fptxs7GYEi3F9BTI6amByNVcX28QElIE6e0baFr4WzI=";

          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          forceGitDeps = true;
          npmInstallFlags = [ "--omit=dev" ];

          buildPhase = "true";

          installPhase =
            let
              appDir = "$out/share/piverxy";
              runtimeDeps = pkgs.lib.makeBinPath [ pkgs.yt-dlp pkgs.ffmpeg ];
              desktop = pkgs.makeDesktopItem {
                name = "Piverxy";
                desktopName = "Piverxy";
                genericName = "Audio Player";
                exec = "piverxy";
                icon = "piverxy";
                categories = [ "AudioVideo" "Audio" "Player" ];
                startupWMClass = "piverxy";
              };
            in
            ''
              runHook preInstall

              mkdir -p ${appDir}
              for f in *; do cp -r "$f" ${appDir}/; done

              mkdir -p $out/bin
              makeWrapper ${pkgs.electron}/bin/electron $out/bin/piverxy \
                --add-flags ${appDir} \
                --prefix PATH : ${runtimeDeps}

              mkdir -p $out/share/applications
              cp ${desktop}/share/applications/*.desktop $out/share/applications/

              mkdir -p $out/share/icons/hicolor/256x256/apps
              cp ${appDir}/assets/icon.png $out/share/icons/hicolor/256x256/apps/piverxy.png

              runHook postInstall
            '';

          meta = with pkgs.lib; {
            description = "Piverxy - audio player made for humans";
            homepage = "https://github.com/MinzTogether/Piverxy";
            license = licenses.mit;
            mainProgram = "piverxy";
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
          default = mkPiverxy pkgs;
          piverxy = mkPiverxy pkgs;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs
            python3
            yt-dlp
            ffmpeg
          ];

          shellHook = ''
            echo "Piverxy dev shell. Install deps and run with:"
            echo "  npm install && npm start"
          '';
        };
      })
    // {
      overlays.default = final: prev: {
        piverxy = mkPiverxy final;
      };
    };
}

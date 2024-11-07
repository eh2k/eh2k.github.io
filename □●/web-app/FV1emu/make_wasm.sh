cd $(dirname $0)

cp ../../lib/claps/cp808.h ../../lib/fv1/;

docker run --rm -v ../../lib/fv1/:/src \
  docker.io/emscripten/emsdk em++ FV1.S.cpp -o fv1.js --bind -WASM=1 \
  -s EXPORTED_FUNCTIONS="['_malloc','_free','_fv1_init','_fv1_load','_fv1_process','_fv1_fake_cv_trig', '_clap808', '_fv1_spn_to_rom']" \
  -s EXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8 \
  -s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE='$stringToAscii'

rm -f ../../lib/fv1/cp808.h
mv -fv ../../lib/fv1/fv1.js ./wasm/;
mv -fv ../../lib/fv1/fv1.wasm ./wasm/;

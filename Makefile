SSU_INPUT ?= input/SceneEN.pck
EXTRACTED_DIR := extracted
OUTPUT_DIR := output

.PHONY: all extract translations preprocess archive patch clean

all: extract translations preprocess archive patch

extract:
	siglus-ssu -x $(SSU_INPUT) $(EXTRACTED_DIR)
	@latest=$$(ls -td $(EXTRACTED_DIR)/output_*/ 2>/dev/null | head -1); \
	rm -rf $(EXTRACTED_DIR)/original; \
	mv "$${latest%/}" $(EXTRACTED_DIR)/original

translations:
	node scripts/apply-translation-patch.js

preprocess:
	node scripts/preprocess.js

archive:
	@latest=$$(ls -td $(EXTRACTED_DIR)/output_*/ 2>/dev/null | head -1); \
	if [ -z "$$latest" ]; then \
		echo "No $(EXTRACTED_DIR)/output_* directory found. Run 'make extract' first." >&2; \
		exit 1; \
	fi; \
	mkdir -p $(OUTPUT_DIR); \
	siglus-ssu -c "$${latest%/}" $(OUTPUT_DIR)/SceneEN.pck; \
	mv $(OUTPUT_DIR)/Gameexe.dat $(OUTPUT_DIR)/GameexeEN.dat

patch:
	$(MAKE) -C patch OUT=$(CURDIR)/$(OUTPUT_DIR)

clean:
	rm -rf $(EXTRACTED_DIR) $(OUTPUT_DIR)

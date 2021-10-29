VERSION := $(shell git describe --tags --abbrev=0 | sed -Ee 's/^v|-.*//')
.PHONY: version
version:
	@echo v$(VERSION)

SEMVER_TYPES := major minor patch
BUMP_TARGETS := $(addprefix version-,$(SEMVER_TYPES))
.PHONY: $(BUMP_TARGETS)
$(BUMP_TARGETS):
	$(eval bump_type := $(strip $(word 2,$(subst -, ,$@))))
	$(eval f := $(words $(shell a="$(SEMVER_TYPES)";echo $${a/$(bump_type)*/$(bump_type)} )))
	$(eval VERSION := $(shell echo $(VERSION) | awk -F. -v OFS=. -v f=$(f) 'f==1 {$$f++; $$2=$$3=0;} f==2 {$$f++; $$3=0;} f==3 {$$f++} 1'))
	@sed -i '' -E "s/version: '.+'/version: '$(VERSION)'/" package.js
	@git add package.js
	@git commit -m "v$(VERSION)"
	@git push
	@git tag v$(VERSION)
	@git push origin v$(VERSION)

.PHONY: publish
publish:
	@meteor publish
